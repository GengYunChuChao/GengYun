# B7 小程序端统一失败／空态／模拟标记收尾（2026-10-21，Refs #28）

任务书 #28 验收第 1 条要求「未登录入口控制、静态地区不假发预警、人审空入口和模拟标记均正确」。
本片只做**状态层统一**：把各页面自写的失败/空/模拟表达收口到一套组件与一套判据，
不改任何页面的业务逻辑、不动 `services/api/**`、`apps/**`、根 `package.json`、CI，不改契约，
也不把「模拟/替身」字样改成「真实」。本文件记录改了什么、每页接入前后什么样、以及**哪些没有被实测**。

---

## 1 统一状态层设计

### 1.1 五个状态与既有组件的对应

任务书要求 `loading` / `empty` / `error(kind)` / `mock` / `denied` 五个状态。既有
`components/state-view`（GY-I26 建立）已有 `guest`/`empty`/`loading`/`error`/`cancelled`/`invalid`/`stub`/`ready` 八种，
因此本片**不重命名既有状态**（重命名会作废既有证据与断言），只做三件增补：

| 任务书状态 | 落地方式 | 说明 |
| --- | --- | --- |
| `loading` | `status="loading"`（既有） | 不变 |
| `empty` | `status="empty"`（既有） | 不变 |
| `error(kind)` | `status="error"` + 新属性 `error-code` | 组件按错误码补一行分类标签（`KIND_LABEL`）与「可以重试／重试无效」 |
| `mock` | `status="mock"` → 组件内 `STATUS_ALIAS` 映射到既有 `stub` | 同一形态、同一文案、同一标签，不新造第二套 |
| `denied` | 新预设 `status="denied"` | 已登录但无权限（403 系列），与 `guest` 分开 |

**为什么 `denied` 必须与 `guest` 分开**：`guest` 是「还没登录」（401），`denied` 是「登录了但这件东西不给你」（403）。
把 403 折叠成「请先登录」，用户会反复登录仍然不明白为什么不行——这是本轮盘点里最实的一处语义缺口：
改前 403 全部落到通用「操作没有成功」，或与 401 一起被当成未登录。

### 1.2 判据集中在 `miniprogram/utils/states.js`

单一事实来源，页面与组件都不再各写一份判断：

- `CODE_KIND`：契约错误码 → 分类（`session`/`denied`/`notfound`/`conflict`/`input`/`throttled`/`unavailable`）。
- `KIND_LABEL`：分类 → 一句中文（如 `没有权限`、`服务暂时不可用`），只补「这是哪类问题」，不替代页面领域文案。
- `KIND_RETRYABLE`：只有 `conflict`/`throttled`/`unavailable` 允许原地重试；`session`/`denied`/`notfound`/`input` 重试无效。
- `statusForCode()`：401→`guest`、403→`denied`、404→`invalid`、其余→`error`；**未知码一律 `error`**（宁可显示通用失败，也不假装成功）。
- `isMockMode(mode)`：`stub`／`preset_demo` 算替身，`real` 不算。
- `resolve(code, fallback)`：给页面用的解析器，返回 `{status, code, kindLabel, retryable, known}`。

契约码来源是 `services/api/src/contract.ts` 的 `ERROR_STATUS_MAP`（契约 1.0.0，只读消费）。
覆盖率由测试对着该文件逐码核对：**漏一个码就红**，因为漏掉的码在真机上就是一片空白。

### 1.3 契约错误码全表（24 码 + 2 个客户端自造码）

| HTTP | 错误码 | 分类 | 组件状态 | 可重试 |
| --- | --- | --- | --- | --- |
| 400 | `INVALID_REQUEST` | input | error | 否 |
| 400 | `INVALID_CURSOR` | input | error | 否 |
| 400 | `IDEMPOTENCY_KEY_REQUIRED` | input | error | 否 |
| 401 | `SESSION_REQUIRED` | session | guest | 否 |
| 401 | `SESSION_EXPIRED` | session | guest | 否 |
| 403 | `SCOPE_DENIED` | denied | denied | 否 |
| 403 | `CONSENT_REQUIRED` | denied | denied | 否 |
| 403 | `ACCOUNT_INACTIVE` | denied | denied | 否 |
| 404 | `NOT_FOUND` | notfound | invalid | 否 |
| 409 | `REVISION_CONFLICT` | conflict | error | 是 |
| 409 | `IDEMPOTENCY_CONFLICT` | conflict | error | 是 |
| 409 | `OBJECT_UNAVAILABLE` | notfound | invalid | 否 |
| 409 | `REQUEST_IN_PROGRESS` | conflict | error | 是 |
| 413 | `MEDIA_TOO_LARGE` | input | error | 否 |
| 415 | `MEDIA_TYPE_UNSUPPORTED` | input | error | 否 |
| 422 | `CONDITIONS_INCOMPLETE` | input | error | 否 |
| 422 | `SOURCE_CONFLICT` | conflict | error | 是 |
| 422 | `INPUT_UNCERTAIN` | input | error | 否 |
| 428 | `REVISION_REQUIRED` | conflict | error | 是 |
| 429 | `RATE_LIMITED` | throttled | error | 是 |
| 429 | `PROVIDER_QUOTA_EXCEEDED` | throttled | error | 是 |
| 503 | `PROVIDER_UNAVAILABLE` | unavailable | error | 是 |
| 503 | `PROVIDER_OUTCOME_UNKNOWN` | unavailable | error | 是 |
| 504 | `PROVIDER_TIMEOUT` | unavailable | error | 是 |
| —（客户端） | `SESSION_CHANGED` | session | guest | 否 |
| —（客户端） | `UNAVAILABLE` | unavailable | error | 是 |

最后两码不在契约里，由本仓 `utils/auth.js` 与各 `*-api.js` 在本地判定「会话被换掉」「服务端未接线」时抛出。
它们**必须有归类**，否则会出现「有错误码但无状态」的空白提示。

### 1.4 视觉规则（沿用 Demo 色板，不新立色板）

| 状态 | 底纹 | 标题色 | 令牌 |
| --- | --- | --- | --- |
| guest | 浅绿 `#eef3e9` | 深绿 `#135b44` | `--green-soft` / `--color-primary-deep` |
| loading | 绿白 `#f2f7f3` | 提示蓝 `#2B6CB0` | `--color-loading` |
| error | 危险浅底 `#f8eeec` | 警告红 `#C53030` | `--tone-danger-bg` / `--color-error` |
| invalid | 提醒黄底 `#f7f1e3` | 提醒黄 `#8A6D1F` | `--tone-warn-bg` / `--color-invalid` |
| **denied** | **石板底 `#eceef3`** | **石板蓝灰 `#4A4E69`** | **`--tone-denied-bg` / `--color-denied`（B7 新增）** |
| stub／mock | 浅紫 `#efeaf7` | 替身紫 `#5B4B8A` | `--tone-stub-bg` / `--color-stub` |

`denied` 取冷灰而非警告红：403 的语气是「锁住了」，不是「坏了」。用户看到红字会以为自己操作出错，
看到一个中立的「没有权限查看」才会去换账号或补授权。红色仍只留给真正的失败。

颜色一律只作辅助，图标与文字承担主要识别（可访问性约定不变）。`denied` 预设图标为 🔐，
`stub` 的「替身数据 · 仅开发模式可见」文字标签逐字保留。

### 1.5 无权限时为什么不给「重试」按钮

`actionSuppressed`：当最终状态是 `denied` 时，组件默认**收起**页面传入的操作按钮。
403 重试一万次也不会变好，留着按钮只会让人白点。但「去授权」这类**针对性**动作是有意义的，
所以留了显式开关 `allow-denied-action`（当前只有识别页的 `permission_denied` 分支使用）。

---

## 2 逐页面接入对照（19 个页面）

判定口径：「接入前」指本片改动前 `miniprogram/pages/<page>/` 的实际内容；「状态块」指 `state-view` 的 `status` 取值。

| 页面 | 接入前 | 接入后 | 本片动作 |
| --- | --- | --- | --- |
| home（Tab1） | 仅 1 处 `stub`；开发工具面板里「处理中／失败」全靠 `button loading` + 一行灰字 `{{status}}` | `stub`／`loading`／`error` | 诊断进行中→`loading`，诊断未通过→`error`；`utils/debug.js` 回调追加 `passed` 参数供页面区分 |
| community（Tab2） | `guest`／`loading`／`error`／`empty` + 自写 `stubNote` 置顶标注 | 同左 4 态 + `error-code` 透传 | 失败态把 `error.code` 交给统一层：403 自动升级成 `denied` 并收起重试 |
| identify（Tab3） | 7 类 `JobState` 收口到组件（`loading`×2／`error`×3／`cancelled`／`ready`）；权限分支走通用 `error` | 增加 `denied`（`permission_denied`→`CONSENT_REQUIRED`） | `error-code` 映射 + `allow-denied-action`，保留「去授权」按钮 |
| messages（Tab4） | `guest`／`loading`／`error`／`empty`／筛选空态 + 自写 `stubNote` 置顶标注 | 5 处状态块 + `error-code` 透传 | 同社区；失败文案仍取 `api.message(error)`／`api.stateTitle(error)`，不改写 |
| profile（Tab5） | `loading`／`error`／`guest`(notice)/`stub`；档案读取失败只说「失败」 | 4 处状态块 + `loadErrorCode` 透传 | 档案读取失败时 403 显示「没有权限查看」而不是「档案暂时读取失败」 |
| communitycreate | `guest` | 不变 | 未改：无失败态需求（投稿失败由页面内联提示，属业务反馈） |
| communitydetail | `guest`／`loading`／`invalid`／`empty` | 不变 | 未改：已覆盖空/失效/加载，错误分支由页面内联处理 |
| favorites | `guest`／`loading`／`error`／`empty` | 不变 | 未改：本片只收口五 Tab，非 Tab 页留待后续统一（见第 5 节） |
| history | `guest`／`loading`／`error`／`empty` | 不变 | 同上 |
| historydetail | `guest`／`loading`／`invalid`／`empty` | 不变 | 同上 |
| knowledge | `guest`／`loading`／`error`／`empty`×3 | 不变 | 同上 |
| knowledgedetail | `guest`／`loading`／`error` | 不变 | 同上 |
| specimen | 11 处状态块（含 `cancelled`／`invalid`／`stub`），是全站状态最全的走查页 | 增至 14 处 | 补 `denied` 走查块与两处 `error-code`（`SCOPE_DENIED`／`PROVIDER_UNAVAILABLE`）样张，让新增语气可在「我的 → 开发工具 → 样式走查」里肉眼核对 |
| login | 无 `state-view`，只有 `{{status}}` 一行文本 + `button loading` | **未接入** | 见第 5 节 |
| reference | 自写 `.reasons`／`.reason`／`.state-bar`／`.empty` 三套表达 | **未接入** | 见第 5 节 |
| referencedetail | 自写 `.state-bar state-unavailable`／`state-ok` + `profileLoading`／`profileError` 文本 | **未接入** | 见第 5 节 |
| referenceseed | 无状态块（纯静态列表） | **未接入** | 无请求即无状态，不硬塞 |
| referenceseeddetail | 无状态块（纯静态详情） | **未接入** | 同上 |
| voice | `notice`／`hint` 内联表达（`recordState`、`uploadErrorCode` 原样带出） | **未接入** | 见第 5 节 |

### 2.1 五 Tab 各接入的状态数

| Tab | 状态数 | 具体状态 |
| --- | --- | --- |
| 首页 home | 3 | `stub`（演示与走查说明）、`loading`（本地诊断中）、`error`（诊断未通过） |
| 社区 community | 4 + 1 | `guest`／`loading`／`error`（+`error-code`）／`empty`，另有置顶替身标注 `notice--stub` + 🧪 |
| 识别 identify | 6 | `loading`／`error`／`cancelled`／`empty`／`ready`（7 类 `JobState` 收口）+ 新增 `denied`（`permission_denied`） |
| 消息 messages | 5 + 1 | `guest`／`loading`／`error`（+`error-code`）／`empty`（列表空）／`empty`（筛选空），另有置顶替身标注 |
| 我的 profile | 4 | `guest`／`loading`／`error`（+`loadErrorCode`）／`stub`，另有未登录 `notice--warn` 入口提示 |

五 Tab 合计 22 处状态块，覆盖任务书要求的全部五个状态类别（`loading`／`empty`／`error(kind)`／`mock`／`denied`）。

---

## 3 模拟标记（不许改成「真实」）

三个 Tab 与两处列表页的替身标记口径**逐字保留**，本片只增加、不删改：

- `components/state-view` 的 `stub` 态：图标 🧪 + 标题「示例数据」 + 说明「当前为开发模式下的替身数据，不是真实识别结果，不能作为用药依据。」 + 文字标签「替身数据 · 仅开发模式可见」。
- `community.wxml` / `messages.wxml` 的置顶替身标注：`notice notice--stub` + 🧪 + `{{stubNote}}`（文案来自 `api.modeNote(mode)`，不新造第二套）。
- 首页「演示与走查状态」块保留原句「真实提供者、真实数据与真机验收未完成，本页所列内容不能作为用药依据。」

测试里有一条**反向守卫**：若统一状态层出现「把模拟说成真实」的措辞（如「已接入真实」），或替身标签被删，即红。

---

## 4 实测证据（本片实际跑过的）

### 4.1 通过的检查

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 新增统一状态层测试 | `node tests/ui-unified-states.test.mjs` | **9 pass / 0 fail** |
| Demo 样式对齐 | `node tests/ui-demo-align.test.mjs` | 10 pass / 0 fail |
| 组件外观 | `node tests/demo-ui-components.test.mjs` | 3 pass / 0 fail |
| 我的页单测 | `node tests/unit/miniprogram-profile.test.mjs` | 28 pass / 0 fail |
| 识别页单测 | `node tests/unit/miniprogram-identify.test.mjs` | 31 pass / 0 fail |
| 适配与门禁 | `node tests/ui-adaptive.test.mjs` | 25 pass / **1 fail（环境）** |
| JS 语法 | `node --check` 遍历 `miniprogram/**/*.js` | 63 个文件全部 OK |
| 打包清单 | `node tools/prepare-wechat.mjs release` | 退出 0；`miniprogram/utils/states.js` 与 `components/state-view/*` 均在生成包内（生成目录随后已删除） |

新增测试 `tests/ui-unified-states.test.mjs` 不是文本 grep：它用 `createRequire` 载入**真实**的
`utils/states.js`，用 `vm.runInNewContext` + 捕获 `Component()` 载入**真实**组件定义（require 白名单只登记
`../../utils/states`），然后真的调用 `refresh()` 逐态断言渲染结果——含 403 升级为 `denied`、`allow-denied-action`
保留「去授权」、`PROVIDER_UNAVAILABLE` 标可重试、`mock` 与 `stub` 同文案、`ready` 不渲染。

### 4.2 没能跑通的（环境限制，必须如实记录）

本会话沙箱**禁止 node 子进程管道**（`spawn`／`spawnSync` 一律 `EPERM`）。由此：

1. `npm run test:mini`（= `node tools/check-wechat-project.mjs && node --test tests/local-debug.test.mjs`）**未能整体通过**：
   - `tools/check-wechat-project.mjs:50` 的 `spawnSync(process.execPath, ['--check', path])` 返回 `null`（`actual: null, expected: 0`）；
   - `tests/local-debug.test.mjs` 6 例中 4 pass、2 fail（isolated packaging 与 local `--appid` 两例），失败同为 `spawnSync` 拿不到子进程。
   - 补偿证据：①上面用 pwsh 直接调 `node --check` 逐个校验了全部 63 个 `.js`；②`local-debug.test.mjs` 中
     「client blocks trial/release/unknown environments and labels stub or failure」一例**通过**，
     证明 `utils/debug.js` 回调整改（追加 `passed` 参数）没有破坏既有行为，且既有调用方只取第一个参数照常工作；
     ③`prepare-wechat.mjs release` 直接跑通，证明允许清单改动正确。
2. `node --test <file>` 同样因 spawn 失败，所以上表逐文件用 `node <file>` 直接执行（`node:test` 在进程内运行，语义相同）。
3. `tests/ui-adaptive.test.mjs` 的 1 个失败是 `execFileSync('git', ['diff','--name-only','origin/main...HEAD'])` 的 `EPERM`，
   属沙箱限制而非代码回归；该用例另有 `/unknown revision/` 才 skip 的设计，其余失败按要求显式暴露（未被我改动绕过）。
4. **微信开发者工具未验证**：本环境没有安装开发者工具、也没有 GUI，`cli` 无法调用，因此
   「打开一次确认编译无报错」**没有做**，也没有逐页面截图。这不代表编译通过，只代表未测。

### 4.3 本片能证明与不能证明的

- 能证明：状态分类与文案在纯函数与组件生命周期层面正确；五 Tab 的 wxml 确实接入了统一组件并透传错误码；
  既有相关单测与样式对齐没有回归；打包允许清单包含新文件；全部 JS 语法合法。
- 不能证明：真机/模拟器渲染效果；开发者工具编译通过；`denied` 在真实 403 响应下的端到端表现
  （本片只用合成错误码验证了组件行为）；非 Tab 页（reference 族、voice、login）的统一。

---

## 5 明确跳过的页面与原因

| 页面 | 跳过原因 |
| --- | --- |
| `login` | 只有一处 `{{status}}` 文本与按钮 `loading`，没有失败/空态分支；登录失败是表单反馈，塞进 `state-view` 会与「未登录」语义打架 |
| `reference` / `referencedetail` | 参考查询族的 `tests/reference/page-gate.test.mjs` 用 vm 载入**真实页面脚本**并按完整说明符登记依赖（未登记即显式失败）。给这些页的 js 新增 `require` 会破坏该夹具体系；本片不做页面 js 依赖变更，故留待后续按同一夹具口径统一 |
| `referenceseed` / `referenceseeddetail` | 纯静态列表/详情，无请求即无状态，硬塞状态块属于为凑数而渲染 |
| `voice` | 播报/录音失败是**逐次操作**的反馈（`recordState`、`uploadErrorCode` 原样带出），与页面级空/失败态不是一件事；且该页已如实显示错误码，未出现「静默灰字」问题 |
| `favorites` / `history` / `historydetail` / `knowledge` / `knowledgedetail` / `communitycreate` / `communitydetail` | **已接入既有 `state-view`**（非跳过），但本片未改它们的错误码透传。它们不属于五 Tab 收尾范围，改动会扩大回归面；如需要，可用同一 `error-code` 属性逐页接上，无需改组件 |

---

## 6 本片改动文件清单

| 文件 | 性质 |
| --- | --- |
| `miniprogram/utils/states.js` | 新增：统一状态层判据（契约码 → 分类 → 状态 → 可否重试） |
| `miniprogram/components/state-view/state-view.js` | 增补：`denied` 预设、`mock→stub` 别名、`error-code`／`allow-denied-action` 属性、`effectiveStatus`/`kindTag`/`retryable`/`actionSuppressed` |
| `miniprogram/components/state-view/state-view.wxml` | 改为按 `effectiveStatus` 渲染，新增分类标签行，按钮受 `actionSuppressed` 约束 |
| `miniprogram/components/state-view/state-view.wxss` | 新增 `.state__kind` 与 `.state--denied` |
| `miniprogram/styles/tokens.wxss` | 新增 `--color-denied`、`--tone-denied-bg` |
| `miniprogram/pages/home/home.js` / `home.wxml` | 诊断处理中/未通过两态接入；新增 `diagPassed` |
| `miniprogram/pages/community/community.js` / `.wxml` | 失败态透传 `errorCode` |
| `miniprogram/pages/messages/messages.js` / `.wxml` | 失败态透传 `errorCode` |
| `miniprogram/pages/profile/profile.js` / `.wxml` | 失败态透传 `loadErrorCode` |
| `miniprogram/pages/identify/identify.wxml` | `permission_denied` → `CONSENT_REQUIRED` + 保留「去授权」 |
| `miniprogram/pages/specimen/specimen.wxml` | 样式走查页补 `denied` 与两处 `error-code` 样张 |
| `miniprogram/utils/debug.js` | 回调追加 `passed`（追加非改语义） |
| `tools/prepare-wechat.mjs` | 允许清单登记 `utils/states.js` |
| `tests/ui-unified-states.test.mjs` | 新增：9 个用例 |
| `docs/ui-state-inventory.md` | 同步第 2 节状态清单（原「实际使用四种」已落后） |
| `docs/verification/gy-i28-unified-states-20261021.md` | 本文件 |

---

## 7 结论

五 Tab 的失败/空态/模拟标记已收口到一套组件与一套判据，403 不再被折叠成「请先登录」或通用失败，
模拟/替身标记逐字保留且受反向守卫保护。非 Tab 页的 `reference` 族与 `voice`、`login` 本轮明确不做（原因见第 5 节）。
真机渲染与开发者工具编译**仍未验证**，本片不据此声称 #28 整项通过。

> **边界注记（2026-10-21，GY-I04 登录链路盘点补）**：上一段「403 不再被折叠成『请先登录』」在本片**只成立于
> 页面呈现层**——页面把 `error.code` 交给 `state-view` 时，403 会被正确升级为 `denied`；但**传输层**当时仍有
> 7 个适配层（favorites／history／knowledge／voice／profile／messages／community）在拿到 403 时先
> `auth.clearSession()` 并把错误码改写成 `SESSION_REQUIRED`，于是统一状态层**根本收不到** 403 码。
> 该传输层缺口已由 `docs/verification/gy-i04-login-chain-20261021.md`
> （`auth.attribution` / `auth.failureFor` 作为单一事实源，`SESSION_LOSS_CODES` 与 `FORBIDDEN_CODES`
> 均由本文件的 `CODE_KIND` 反推）补齐并加测试。本页历史结论保留，不改写当时读数。
